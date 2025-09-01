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
  __esModule: true,
  default: {
    broadcastToUser: jest.fn(),
    broadcastToVenue: jest.fn(),
    getBroadcastingService: jest.fn(() => ({
      broadcastNewNotification: jest.fn(),
      broadcastNotificationRead: jest.fn(),
      broadcastNotificationDeleted: jest.fn(),
    })),
  },
}))

// Mock Prisma Client
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    notification: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    staff: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    staffVenue: {
      findMany: jest.fn(),
    },
    venue: {
      findUnique: jest.fn(),
    },
    notificationPreference: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
// const socketService = require('../../communication/sockets/services/broadcasting.service')

describe('Notification Dashboard Service', () => {
  const mockPrismaNotificationCreate = prisma.notification.create as jest.Mock
  const mockPrismaNotificationFindMany = prisma.notification.findMany as jest.Mock
  const mockPrismaNotificationFindFirst = prisma.notification.findFirst as jest.Mock
  const mockPrismaNotificationUpdate = prisma.notification.update as jest.Mock
  const mockPrismaNotificationUpdateMany = prisma.notification.updateMany as jest.Mock
  const mockPrismaNotificationDelete = prisma.notification.delete as jest.Mock
  const mockPrismaNotificationDeleteMany = prisma.notification.deleteMany as jest.Mock
  const mockPrismaNotificationCount = prisma.notification.count as jest.Mock
  const mockPrismaStaffFindUnique = prisma.staff.findUnique as jest.Mock
  // const mockPrismaStaffFindMany = prisma.staff.findMany as jest.Mock
  const mockPrismaStaffVenueFindMany = prisma.staffVenue.findMany as jest.Mock
  const mockPrismaVenueFindUnique = prisma.venue.findUnique as jest.Mock
  const mockPrismaNotificationPreferenceFindFirst = prisma.notificationPreference.findFirst as jest.Mock
  const mockPrismaNotificationPreferenceCreate = prisma.notificationPreference.create as jest.Mock
  // const mockSocketBroadcastToUser = socketService.broadcastToUser as jest.Mock
  // const mockSocketBroadcastToVenue = socketService.broadcastToVenue as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    // Default mock setups
    mockPrismaStaffFindUnique.mockResolvedValue({ id: 'user-123', firstName: 'Test User' })
    mockPrismaVenueFindUnique.mockResolvedValue({ id: 'venue-456', name: 'Test Venue' })
    mockPrismaNotificationPreferenceFindFirst.mockResolvedValue({
      id: 'pref-123',
      userId: 'user-123',
      inAppEnabled: true,
      emailEnabled: false,
      pushEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      enabled: true,
    })
    mockPrismaNotificationPreferenceCreate.mockResolvedValue({
      id: 'pref-123',
      userId: 'user-123',
      inAppEnabled: true,
      emailEnabled: false,
      pushEnabled: false,
      enabled: true,
    })
    mockPrismaNotificationCreate.mockResolvedValue({
      id: 'notif-789',
      recipientId: 'user-123',
      venueId: 'venue-456',
      type: NotificationType.ORDER_UPDATED,
      title: 'New Order',
      message: 'You have a new order #123',
      priority: NotificationPriority.NORMAL,
      channels: [NotificationChannel.IN_APP],
      isRead: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      actionUrl: null,
      actionLabel: null,
      entityType: null,
      entityId: null,
      metadata: null,
    })
    mockPrismaNotificationCount.mockResolvedValue(2)
    mockPrismaNotificationUpdateMany.mockResolvedValue({ count: 5 })
    mockPrismaNotificationDeleteMany.mockResolvedValue({ count: 10 })
    mockPrismaNotificationFindMany.mockResolvedValue([
      {
        id: 'notif-1',
        recipientId: 'user-123',
        title: 'Notification 1',
        message: 'Message 1',
        isRead: false,
        createdAt: new Date(),
      },
      {
        id: 'notif-2',
        recipientId: 'user-123',
        title: 'Notification 2',
        message: 'Message 2',
        isRead: true,
        createdAt: new Date(),
      },
    ])
    mockPrismaNotificationFindFirst.mockResolvedValue({
      id: 'notif-123',
      recipientId: 'user-123',
      isRead: false,
      venueId: 'venue-456',
    })
    mockPrismaNotificationUpdate.mockResolvedValue({
      id: 'notif-123',
      recipientId: 'user-123',
      isRead: true,
    })
    mockPrismaStaffVenueFindMany.mockResolvedValue([{ staff: { id: 'staff-1' } }, { staff: { id: 'staff-2' } }])
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

      mockPrismaNotificationCreate.mockResolvedValue(mockCreatedNotification)

      // Act
      const result = await createNotification(mockNotificationData)

      // Assert
      expect(result).toEqual(
        expect.objectContaining({
          id: 'notif-789',
          recipientId: 'user-123',
          venueId: 'venue-456',
          type: NotificationType.ORDER_UPDATED,
          title: 'New Order',
          message: 'You have a new order #123',
          priority: NotificationPriority.NORMAL,
          channels: [NotificationChannel.IN_APP],
          isRead: false,
        }),
      )
      expect(mockPrismaNotificationCreate).toHaveBeenCalledWith({
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

      mockPrismaNotificationCreate.mockRejectedValue(new Error('Database error'))

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

      mockPrismaNotificationFindMany.mockResolvedValue(mockNotifications)
      mockPrismaNotificationCount.mockResolvedValue(2)

      // Act
      const result = await getUserNotifications(userId, undefined, {}, { page: 1, limit: 10 })

      // Assert
      expect(result.notifications).toEqual(mockNotifications)
      expect(result.total).toBe(2)
      expect(result.unreadCount).toBe(2)
      expect(mockPrismaNotificationFindMany).toHaveBeenCalledWith({
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
      const userId = 'user-123'
      const mockUpdatedNotification = {
        id: notificationId,
        recipientId: userId,
        isRead: true,
      } as Notification

      mockPrismaNotificationFindFirst.mockResolvedValue({
        id: notificationId,
        recipientId: userId,
        isRead: false,
      } as any)

      mockPrismaNotificationUpdate.mockResolvedValue(mockUpdatedNotification)

      // Act
      const result = await markNotificationAsRead(notificationId, userId)

      // Assert
      expect(result).toEqual(mockUpdatedNotification)
      expect(mockPrismaNotificationUpdate).toHaveBeenCalledWith({
        where: { id: notificationId },
        data: {
          isRead: true,
          readAt: expect.any(Date),
        },
      })
    })

    it('should throw error if notification not found or not owned by user', async () => {
      // Arrange
      mockPrismaNotificationFindFirst.mockResolvedValue(null)

      // Act & Assert
      await expect(markNotificationAsRead('invalid-id', 'user-123')).rejects.toThrow('Notification with ID invalid-id not found')
    })
  })

  describe('markAllNotificationsAsRead', () => {
    it('should mark all user notifications as read', async () => {
      // Arrange
      const userId = 'user-123'
      mockPrismaNotificationUpdateMany.mockResolvedValue({ count: 5 })

      // Act
      const result = await markAllNotificationsAsRead(userId)

      // Assert
      expect(result.count).toBe(5)
      expect(mockPrismaNotificationUpdateMany).toHaveBeenCalledWith({
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

      mockPrismaNotificationFindFirst.mockResolvedValue({
        id: notificationId,
        recipientId: userId,
      } as any)

      mockPrismaNotificationDelete.mockResolvedValue({} as any)

      // Act
      await deleteNotification(notificationId, userId)

      // Assert
      expect(mockPrismaNotificationDelete).toHaveBeenCalledWith({
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
      expect(mockPrismaStaffVenueFindMany).toHaveBeenCalledWith({
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
      mockPrismaNotificationDeleteMany.mockResolvedValue({ count: 10 })

      // Act
      const result = await cleanupOldNotifications(olderThanDays)

      // Assert
      expect(result).toBe(10)
      expect(mockPrismaNotificationDeleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: {
            lt: expect.any(Date),
          },
          isRead: true,
        },
      })
    })
  })
})
