/**
 * Mobile Notification Controller
 *
 * Handles notification listing, read status, and deletion for mobile apps.
 * Notifications are USER-scoped (recipientId), not venue-scoped.
 */

import { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import * as notificationService from '../../services/dashboard/notification.dashboard.service'

// ===== VALIDATION SCHEMAS =====

const getNotificationsSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
})

// ===== CONTROLLER FUNCTIONS =====

/**
 * Get user notifications (paginated)
 * GET /api/v1/mobile/notifications
 */
export const getUserNotifications = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authContext?.userId

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    }

    const query = getNotificationsSchema.parse(req.query)
    const { page, limit } = query

    const result = await notificationService.getUserNotifications(userId, undefined, {}, { page, limit })

    return res.json({
      success: true,
      data: {
        notifications: result.notifications,
        pagination: {
          page,
          limit,
          total: result.total,
          totalPages: Math.ceil(result.total / limit),
        },
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get unread notifications count
 * GET /api/v1/mobile/notifications/unread-count
 */
export const getUnreadCount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authContext?.userId

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    }

    const result = await notificationService.getUserNotifications(userId, undefined, { isRead: false }, { limit: 1 })

    return res.json({
      success: true,
      data: { count: result.unreadCount },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Mark a single notification as read
 * PATCH /api/v1/mobile/notifications/:notificationId/read
 */
export const markAsRead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authContext?.userId
    const { notificationId } = req.params

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    }

    const notification = await notificationService.markNotificationAsRead(notificationId, userId)

    return res.json({
      success: true,
      data: notification,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Mark all unread notifications as read for the user
 * PATCH /api/v1/mobile/notifications/mark-all-read
 */
export const markAllAsRead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authContext?.userId

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    }

    const result = await notificationService.markAllNotificationsAsRead(userId)

    return res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete a notification
 * DELETE /api/v1/mobile/notifications/:notificationId
 */
export const deleteNotification = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authContext?.userId
    const { notificationId } = req.params

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    }

    await notificationService.deleteNotification(notificationId, userId)

    return res.json({
      success: true,
      data: { deleted: true },
    })
  } catch (error) {
    next(error)
  }
}
