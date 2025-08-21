import { Request, Response } from 'express'
import { z } from 'zod'
import * as notificationService from '../../services/dashboard/notification.dashboard.service'
import { NotificationType, NotificationPriority, NotificationChannel } from '@prisma/client'
import { BadRequestError } from '../../errors/AppError'
import asyncHandler from '../../utils/asyncHandler'
import { AuthContext } from '../../security'

// Extend Request type to include authContext
interface AuthenticatedRequest extends Request {
  authContext?: AuthContext
}

// API Response utility function
function formatApiResponse(data: any, message?: string) {
  return {
    success: true,
    message: message || 'Success',
    data,
  }
}

// ===== VALIDATION SCHEMAS =====

const createNotificationSchema = z.object({
  recipientId: z.string().cuid(),
  venueId: z.string().cuid().optional(),
  type: z.nativeEnum(NotificationType),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(1000),
  actionUrl: z.string().url().optional(),
  actionLabel: z.string().max(50).optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  priority: z.nativeEnum(NotificationPriority).optional(),
  channels: z.array(z.nativeEnum(NotificationChannel)).optional(),
})

const getNotificationsSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  sortBy: z.enum(['createdAt', 'updatedAt', 'priority']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  isRead: z.coerce.boolean().optional(),
  type: z.nativeEnum(NotificationType).optional(),
  priority: z.nativeEnum(NotificationPriority).optional(),
  entityType: z.string().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
})

const updatePreferencesSchema = z.object({
  type: z.nativeEnum(NotificationType),
  enabled: z.boolean().optional(),
  channels: z.array(z.nativeEnum(NotificationChannel)).optional(),
  priority: z.nativeEnum(NotificationPriority).optional(),
  quietStart: z
    .string()
    .regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .optional(),
  quietEnd: z
    .string()
    .regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .optional(),
})

const bulkNotificationSchema = z.object({
  recipientIds: z.array(z.string().cuid()).min(1),
  venueId: z.string().cuid().optional(),
  type: z.nativeEnum(NotificationType),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(1000),
  actionUrl: z.string().url().optional(),
  actionLabel: z.string().max(50).optional(),
  priority: z.nativeEnum(NotificationPriority).optional(),
})

// ===== CONTROLLER FUNCTIONS =====

/**
 * Create a new notification
 * POST /api/v1/dashboard/notifications
 */
export const createNotification = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const validatedData = createNotificationSchema.parse(req.body)

  const notification = await notificationService.createNotification(validatedData)

  return res.status(201).json(formatApiResponse(notification, 'Notification created successfully'))
})

/**
 * Get user notifications
 * GET /api/v1/dashboard/notifications
 */
export const getUserNotifications = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.authContext?.userId
  const venueId = req.headers['x-venue-id'] as string

  if (!userId) {
    throw new BadRequestError('User ID is required')
  }

  const query = getNotificationsSchema.parse(req.query)

  const { page, limit, sortBy, sortOrder, ...filters } = query

  const result = await notificationService.getUserNotifications(userId, venueId, filters, { page, limit, sortBy, sortOrder })

  return res.json(
    formatApiResponse(
      {
        notifications: result.notifications,
        pagination: {
          page,
          limit,
          total: result.total,
          totalPages: Math.ceil(result.total / limit),
        },
        unreadCount: result.unreadCount,
      },
      'Notifications retrieved successfully',
    ),
  )
})

/**
 * Get unread count
 * GET /api/v1/dashboard/notifications/unread-count
 */
export const getUnreadCount = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.authContext?.userId
  const venueId = req.headers['x-venue-id'] as string

  if (!userId) {
    throw new BadRequestError('User ID is required')
  }

  const result = await notificationService.getUserNotifications(userId, venueId, { isRead: false }, { limit: 1 })

  return res.json(formatApiResponse({ count: result.unreadCount }, 'Unread count retrieved successfully'))
})

/**
 * Mark notification as read
 * PATCH /api/v1/dashboard/notifications/:id/read
 */
export const markAsRead = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const notificationId = req.params.id
  const userId = req.authContext?.userId

  if (!userId) {
    throw new BadRequestError('User ID is required')
  }

  const notification = await notificationService.markNotificationAsRead(notificationId, userId)

  return res.json(formatApiResponse(notification, 'Notification marked as read'))
})

/**
 * Mark all notifications as read
 * PATCH /api/v1/dashboard/notifications/mark-all-read
 */
export const markAllAsRead = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.authContext?.userId
  const venueId = req.headers['x-venue-id'] as string

  if (!userId) {
    throw new BadRequestError('User ID is required')
  }

  const result = await notificationService.markAllNotificationsAsRead(userId, venueId)

  return res.json(formatApiResponse(result, `${result.count} notifications marked as read`))
})

/**
 * Delete notification
 * DELETE /api/v1/dashboard/notifications/:id
 */
export const deleteNotification = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const notificationId = req.params.id
  const userId = req.authContext?.userId

  if (!userId) {
    throw new BadRequestError('User ID is required')
  }

  await notificationService.deleteNotification(notificationId, userId)

  return res.status(204).send()
})

/**
 * Get notification preferences
 * GET /api/v1/dashboard/notifications/preferences
 */
export const getPreferences = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.authContext?.userId
  const venueId = req.headers['x-venue-id'] as string

  if (!userId) {
    throw new BadRequestError('User ID is required')
  }

  const preferences = await notificationService.getAllUserPreferences(userId, venueId)

  return res.json(formatApiResponse(preferences, 'Notification preferences retrieved successfully'))
})

/**
 * Update notification preferences
 * PUT /api/v1/dashboard/notifications/preferences
 */
export const updatePreferences = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.authContext?.userId
  const venueId = req.headers['x-venue-id'] as string

  if (!userId) {
    throw new BadRequestError('User ID is required')
  }

  const validatedData = updatePreferencesSchema.parse(req.body)

  const preference = await notificationService.updateNotificationPreferences(userId, venueId || null, validatedData.type, validatedData)

  return res.json(formatApiResponse(preference, 'Notification preferences updated successfully'))
})

/**
 * Send bulk notifications (admin only)
 * POST /api/v1/dashboard/notifications/bulk
 */
export const sendBulkNotification = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const validatedData = bulkNotificationSchema.parse(req.body)

  const notifications = await notificationService.sendBulkNotification(validatedData.recipientIds, {
    venueId: validatedData.venueId,
    type: validatedData.type,
    title: validatedData.title,
    message: validatedData.message,
    actionUrl: validatedData.actionUrl,
    actionLabel: validatedData.actionLabel,
    priority: validatedData.priority,
  })

  return res.status(201).json(
    formatApiResponse(
      {
        sent: notifications.length,
        notifications,
      },
      `${notifications.length} notifications sent successfully`,
    ),
  )
})

/**
 * Send venue-wide notification (admin only)
 * POST /api/v1/dashboard/notifications/venue/:venueId
 */
export const sendVenueNotification = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const venueId = req.params.venueId
  const { roles, ...notificationData } = req.body

  const validatedData = z
    .object({
      type: z.nativeEnum(NotificationType),
      title: z.string().min(1).max(200),
      message: z.string().min(1).max(1000),
      actionUrl: z.string().url().optional(),
      actionLabel: z.string().max(50).optional(),
      priority: z.nativeEnum(NotificationPriority).optional(),
    })
    .parse(notificationData)

  const notifications = await notificationService.sendVenueNotification(venueId, validatedData, roles)

  return res.status(201).json(
    formatApiResponse(
      {
        sent: notifications.length,
        notifications,
      },
      `${notifications.length} notifications sent to venue staff`,
    ),
  )
})

/**
 * Get notification types (for frontend dropdowns)
 * GET /api/v1/dashboard/notifications/types
 */
export const getNotificationTypes = asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
  const types = Object.values(NotificationType).map(type => ({
    value: type,
    label: type
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, l => l.toUpperCase()),
  }))

  return res.json(formatApiResponse({ types }, 'Notification types retrieved successfully'))
})
