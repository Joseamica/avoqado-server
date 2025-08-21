import prisma from '../../utils/prismaClient'
import { NotificationType, NotificationPriority, NotificationChannel, Notification, NotificationPreference } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import socketManager from '../../communication/sockets'

// ===== TYPES =====

export interface CreateNotificationDto {
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

export interface NotificationWithRelations extends Notification {
  recipient: {
    id: string
    firstName: string
    lastName: string
    email: string
  }
  venue?: {
    id: string
    name: string
    slug: string
  } | null
}

export interface NotificationFilters {
  isRead?: boolean
  type?: NotificationType
  priority?: NotificationPriority
  venueId?: string
  entityType?: string
  startDate?: Date
  endDate?: Date
}

export interface PaginationOptions {
  page?: number
  limit?: number
  sortBy?: 'createdAt' | 'updatedAt' | 'priority'
  sortOrder?: 'asc' | 'desc'
}

// ===== NOTIFICATION CRUD =====

/**
 * Create a new notification
 */
export async function createNotification(data: CreateNotificationDto): Promise<Notification> {
  // Check if recipient exists
  const recipient = await prisma.staff.findUnique({
    where: { id: data.recipientId },
  })

  if (!recipient) {
    throw new NotFoundError(`Staff member with ID ${data.recipientId} not found`)
  }

  // Check venue if provided
  if (data.venueId) {
    const venue = await prisma.venue.findUnique({
      where: { id: data.venueId },
    })

    if (!venue) {
      throw new NotFoundError(`Venue with ID ${data.venueId} not found`)
    }
  }

  // Get user preferences for this notification type
  const preferences = await getUserNotificationPreferences(data.recipientId, data.venueId, data.type)

  // Skip if user has disabled this type
  if (!preferences.enabled) {
    console.log(`Notification ${data.type} skipped for user ${data.recipientId} - disabled in preferences`)
    throw new Error('Notification disabled in preferences')
  }

  // Check quiet hours
  if (isInQuietHours(preferences.quietStart || undefined, preferences.quietEnd || undefined)) {
    console.log(`Notification ${data.type} skipped for user ${data.recipientId} - quiet hours`)
    throw new Error('Notification skipped due to quiet hours')
  }

  const notification = await prisma.notification.create({
    data: {
      recipientId: data.recipientId,
      venueId: data.venueId,
      type: data.type,
      title: data.title,
      message: data.message,
      actionUrl: data.actionUrl,
      actionLabel: data.actionLabel,
      entityType: data.entityType,
      entityId: data.entityId,
      metadata: data.metadata,
      priority: data.priority || preferences.priority || NotificationPriority.NORMAL,
      channels: data.channels || preferences.channels || [NotificationChannel.IN_APP],
      sentAt: new Date(),
    },
  })

  // Broadcast the new notification via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastNewNotification({
      notificationId: notification.id,
      recipientId: notification.recipientId,
      venueId: notification.venueId || '',
      userId: notification.recipientId,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      priority: notification.priority as 'LOW' | 'NORMAL' | 'HIGH',
      isRead: notification.isRead,
      actionUrl: notification.actionUrl || undefined,
      actionLabel: notification.actionLabel || undefined,
      metadata: (notification.metadata as Record<string, any>) || undefined,
    })
  }

  return notification
}

/**
 * Get notifications for a user
 */
export async function getUserNotifications(
  userId: string,
  venueId?: string,
  filters: NotificationFilters = {},
  pagination: PaginationOptions = {},
): Promise<{
  notifications: NotificationWithRelations[]
  total: number
  unreadCount: number
}> {
  const { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = pagination

  const where = {
    recipientId: userId,
    ...(venueId && { venueId }),
    ...(filters.isRead !== undefined && { isRead: filters.isRead }),
    ...(filters.type && { type: filters.type }),
    ...(filters.priority && { priority: filters.priority }),
    ...(filters.entityType && { entityType: filters.entityType }),
    ...(filters.startDate &&
      filters.endDate && {
        createdAt: {
          gte: filters.startDate,
          lte: filters.endDate,
        },
      }),
  }

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      include: {
        recipient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
      orderBy: {
        [sortBy]: sortOrder,
      },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({
      where: {
        ...where,
        isRead: false,
      },
    }),
  ])

  return {
    notifications,
    total,
    unreadCount,
  }
}

/**
 * Mark notification as read
 */
export async function markNotificationAsRead(notificationId: string, userId: string): Promise<Notification> {
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      recipientId: userId,
    },
  })

  if (!notification) {
    throw new NotFoundError(`Notification with ID ${notificationId} not found`)
  }

  if (notification.isRead) {
    return notification
  }

  const updatedNotification = await prisma.notification.update({
    where: { id: notificationId },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  })

  // Broadcast the notification read event via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastNotificationRead(notificationId, userId, notification.venueId || '')
  }

  return updatedNotification
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllNotificationsAsRead(userId: string, venueId?: string): Promise<{ count: number }> {
  const where = {
    recipientId: userId,
    isRead: false,
    ...(venueId && { venueId }),
  }

  const result = await prisma.notification.updateMany({
    where,
    data: {
      isRead: true,
      readAt: new Date(),
    },
  })

  return { count: result.count }
}

/**
 * Delete notification
 */
export async function deleteNotification(notificationId: string, userId: string): Promise<void> {
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      recipientId: userId,
    },
  })

  if (!notification) {
    throw new NotFoundError(`Notification with ID ${notificationId} not found`)
  }

  const wasUnread = !notification.isRead

  await prisma.notification.delete({
    where: { id: notificationId },
  })

  // Broadcast the notification deletion event via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastNotificationDeleted(notificationId, userId, notification.venueId || '', wasUnread)
  }
}

// ===== NOTIFICATION PREFERENCES =====

/**
 * Get user notification preferences
 */
export async function getUserNotificationPreferences(
  staffId: string,
  venueId?: string | null,
  type?: NotificationType,
): Promise<NotificationPreference> {
  const where = {
    staffId,
    venueId,
    ...(type && { type }),
  }

  let preference = await prisma.notificationPreference.findFirst({
    where,
  })

  // If no preference exists, create default one
  if (!preference && type) {
    preference = await prisma.notificationPreference.create({
      data: {
        staffId,
        venueId,
        type,
        enabled: true,
        channels: [NotificationChannel.IN_APP],
        priority: NotificationPriority.NORMAL,
      },
    })
  }

  return (
    preference ||
    ({
      enabled: true,
      channels: [NotificationChannel.IN_APP],
      priority: NotificationPriority.NORMAL,
      quietStart: null,
      quietEnd: null,
    } as any)
  )
}

/**
 * Update notification preferences
 */
export async function updateNotificationPreferences(
  staffId: string,
  venueId: string | null,
  type: NotificationType,
  updates: {
    enabled?: boolean
    channels?: NotificationChannel[]
    priority?: NotificationPriority
    quietStart?: string
    quietEnd?: string
  },
): Promise<NotificationPreference> {
  const existing = await prisma.notificationPreference.findFirst({
    where: {
      staffId,
      venueId,
      type,
    },
  })

  if (existing) {
    return await prisma.notificationPreference.update({
      where: { id: existing.id },
      data: updates,
    })
  } else {
    return await prisma.notificationPreference.create({
      data: {
        staffId,
        venueId,
        type,
        ...updates,
      },
    })
  }
}

/**
 * Get all preferences for a user
 */
export async function getAllUserPreferences(staffId: string, venueId?: string): Promise<NotificationPreference[]> {
  return await prisma.notificationPreference.findMany({
    where: {
      staffId,
      ...(venueId && { venueId }),
    },
    orderBy: {
      type: 'asc',
    },
  })
}

// ===== NOTIFICATION TEMPLATES =====

/**
 * Create notification from template
 */
export async function createNotificationFromTemplate(
  type: NotificationType,
  recipientId: string,
  variables: Record<string, any> = {},
  options: Partial<CreateNotificationDto> = {},
): Promise<Notification> {
  const template = await prisma.notificationTemplate.findFirst({
    where: {
      type,
      active: true,
      language: 'es', // Default language
    },
  })

  if (!template) {
    throw new NotFoundError(`No active template found for notification type ${type}`)
  }

  // Replace variables in template
  const title = replaceTemplateVariables(template.title, variables)
  const message = replaceTemplateVariables(template.message, variables)
  const actionLabel = template.actionLabel ? replaceTemplateVariables(template.actionLabel, variables) : undefined

  return await createNotification({
    recipientId,
    type,
    title,
    message,
    actionLabel,
    ...options,
  })
}

// ===== BULK NOTIFICATIONS =====

/**
 * Send notification to multiple users
 */
export async function sendBulkNotification(
  recipientIds: string[],
  notificationData: Omit<CreateNotificationDto, 'recipientId'>,
): Promise<Notification[]> {
  const notifications = await Promise.all(
    recipientIds.map(recipientId =>
      createNotification({
        ...notificationData,
        recipientId,
      }),
    ),
  )

  return notifications.filter(Boolean) // Remove null results (disabled notifications)
}

/**
 * Send notification to all staff in a venue
 */
export async function sendVenueNotification(
  venueId: string,
  notificationData: Omit<CreateNotificationDto, 'recipientId' | 'venueId'>,
  roleFilter?: string[],
): Promise<Notification[]> {
  const venueStaff = await prisma.staffVenue.findMany({
    where: {
      venueId,
      active: true,
      ...(roleFilter &&
        roleFilter.length > 0 && {
          role: {
            in: roleFilter as any[],
          },
        }),
    },
    include: {
      staff: {
        select: {
          id: true,
        },
      },
    },
  })

  const recipientIds = venueStaff.map(sv => sv.staff.id)

  return await sendBulkNotification(recipientIds, {
    ...notificationData,
    venueId,
  })
}

// ===== UTILITY FUNCTIONS =====

/**
 * Check if current time is in quiet hours
 */
function isInQuietHours(quietStart?: string, quietEnd?: string): boolean {
  if (!quietStart || !quietEnd) return false

  const now = new Date()
  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

  const start = quietStart
  const end = quietEnd

  // Handle overnight quiet hours (e.g., 22:00 to 08:00)
  if (start > end) {
    return currentTime >= start || currentTime <= end
  }

  // Handle same-day quiet hours (e.g., 13:00 to 14:00)
  return currentTime >= start && currentTime <= end
}

/**
 * Replace template variables with actual values
 */
function replaceTemplateVariables(template: string, variables: Record<string, any>): string {
  let result = template

  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g')
    result = result.replace(regex, String(value))
  })

  return result
}

// ===== CLEANUP =====

/**
 * Delete old notifications
 */
export async function cleanupOldNotifications(olderThanDays: number = 30): Promise<number> {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays)

  const result = await prisma.notification.deleteMany({
    where: {
      createdAt: {
        lt: cutoffDate,
      },
      isRead: true,
    },
  })

  return result.count
}
