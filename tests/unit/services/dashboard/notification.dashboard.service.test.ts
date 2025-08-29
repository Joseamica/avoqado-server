import {
  createNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  sendVenueNotification,
  cleanupOldNotifications,
} from '../../../../src/services/dashboard/notification.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import { NotificationType, NotificationPriority, NotificationChannel, Notification } from '@prisma/client'

// Mock Socket.IO
jest.mock('../../../../src/communication/sockets', () => ({
  default: {
    broadcastToUser: jest.fn(),
    broadcastToVenue: jest.fn(),
  },
}))

describe('Notification Dashboard Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('createNotification', () => {
    it('should create a notification successfully', async () => {
      // Arrange
      const mockNotificationData = {
        recipientId: 'user-123',
        venueId: 'venue-456',
        type: NotificationType.ORDER_UPDATED,
        title: 'New Order',
        message: 'You have a new order #123',
        priority: NotificationPriority.NORMAL,
        channels: [NotificationChannel.IN_APP],
      }

      const mockCreatedNotification = {
        id: 'notif-789',
        ...mockNotificationData,
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        actionUrl: null,
        actionLabel: null,
        entityType: null,
        entityId: null,
        metadata: null,
      } as Notification

      prismaMock.notification.create.mockResolvedValue(mockCreatedNotification)

      // Act
      const result = await createNotification(mockNotificationData)

      // Assert
      expect(result).toEqual(mockCreatedNotification)
      expect(prismaMock.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recipientId: 'user-123',
          venueId: 'venue-456',
          type: NotificationType.ORDER_UPDATED,
          title: 'New Order',
          message: 'You have a new order #123',
        }),
      })
    })

    it('should handle notification creation error', async () => {
      // Arrange
      const mockNotificationData = {
        recipientId: 'user-123',
        type: NotificationType.ORDER_UPDATED,
        title: 'Test',
        message: 'Test message',
      }

      prismaMock.notification.create.mockRejectedValue(new Error('Database error'))

      // Act & Assert
      await expect(createNotification(mockNotificationData)).rejects.toThrow('Database error')
    })
  })

  describe('getUserNotifications', () => {
    it('should fetch user notifications with pagination', async () => {
      // Arrange
      const userId = 'user-123'
      const mockNotifications = [
        {
          id: 'notif-1',
          recipientId: userId,
          title: 'Notification 1',
          message: 'Message 1',
          isRead: false,
          createdAt: new Date(),
        },
        {
          id: 'notif-2',
          recipientId: userId,
          title: 'Notification 2',
          message: 'Message 2',
          isRead: true,
          createdAt: new Date(),
        },
      ]

      prismaMock.notification.findMany.mockResolvedValue(mockNotifications)
      prismaMock.notification.count.mockResolvedValue(2)

      // Act
      const result = await getUserNotifications(userId, undefined, {}, { page: 1, limit: 10 })

      // Assert
      expect(result.notifications).toEqual(mockNotifications)
      expect(result.total).toBe(2)
      expect(result.unreadCount).toBe(2)
      expect(prismaMock.notification.findMany).toHaveBeenCalledWith({
        where: { recipientId: userId },
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
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 10,
      })
    })
  })

  describe('markNotificationAsRead', () => {
    it('should mark notification as read', async () => {
      // Arrange
      const notificationId = 'notif-123'
      const userId = 'user-456'
      const mockUpdatedNotification = {
        id: notificationId,
        recipientId: userId,
        isRead: true,
        updatedAt: new Date(),
      } as Notification

      prismaMock.notification.findFirst.mockResolvedValue({
        id: notificationId,
        recipientId: userId,
        isRead: false,
      } as any)

      prismaMock.notification.update.mockResolvedValue(mockUpdatedNotification)

      // Act
      const result = await markNotificationAsRead(notificationId, userId)

      // Assert
      expect(result).toEqual(mockUpdatedNotification)
      expect(prismaMock.notification.update).toHaveBeenCalledWith({
        where: { id: notificationId },
        data: {
          isRead: true,
          readAt: expect.any(Date),
        },
      })
    })

    it('should throw error if notification not found or not owned by user', async () => {
      // Arrange
      prismaMock.notification.findFirst.mockResolvedValue(null)

      // Act & Assert
      await expect(markNotificationAsRead('invalid-id', 'user-123')).rejects.toThrow('Notification not found or access denied')
    })
  })

  describe('markAllNotificationsAsRead', () => {
    it('should mark all user notifications as read', async () => {
      // Arrange
      const userId = 'user-123'
      prismaMock.notification.updateMany.mockResolvedValue({ count: 5 })

      // Act
      const result = await markAllNotificationsAsRead(userId)

      // Assert
      expect(result.count).toBe(5)
      expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
        where: {
          recipientId: userId,
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: expect.any(Date),
        },
      })
    })
  })

  describe('deleteNotification', () => {
    it('should delete notification owned by user', async () => {
      // Arrange
      const notificationId = 'notif-123'
      const userId = 'user-456'

      prismaMock.notification.findFirst.mockResolvedValue({
        id: notificationId,
        recipientId: userId,
      } as any)

      prismaMock.notification.delete.mockResolvedValue({} as any)

      // Act
      await deleteNotification(notificationId, userId)

      // Assert
      expect(prismaMock.notification.delete).toHaveBeenCalledWith({
        where: { id: notificationId },
      })
    })
  })

  describe('sendVenueNotification', () => {
    it('should send notification to all venue staff', async () => {
      // Arrange
      const venueId = 'venue-123'
      const mockStaff = [{ staffId: 'staff-1' }, { staffId: 'staff-2' }]

      const mockNotificationData = {
        type: NotificationType.ANNOUNCEMENT,
        title: 'Venue Update',
        message: 'Important announcement',
      }

      prismaMock.staffVenue.findMany.mockResolvedValue(mockStaff as any)
      prismaMock.notification.createMany.mockResolvedValue({ count: 2 })
      prismaMock.notification.findMany.mockResolvedValue([
        { id: 'notif-1', recipientId: 'staff-1' },
        { id: 'notif-2', recipientId: 'staff-2' },
      ] as any)

      // Act
      const result = await sendVenueNotification(venueId, mockNotificationData)

      // Assert
      expect(result).toHaveLength(2)
      expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith({
        where: {
          venueId,
          active: true,
        },
        include: {
          staff: {
            select: {
              id: true,
            },
          },
        },
      })
    })
  })

  describe('cleanupOldNotifications', () => {
    it('should delete old notifications', async () => {
      // Arrange
      const olderThanDays = 30
      prismaMock.notification.deleteMany.mockResolvedValue({ count: 10 })

      // Act
      const result = await cleanupOldNotifications(olderThanDays)

      // Assert
      expect(result).toBe(10)
      expect(prismaMock.notification.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: {
            lt: expect.any(Date),
          },
        },
      })
    })
  })
})
