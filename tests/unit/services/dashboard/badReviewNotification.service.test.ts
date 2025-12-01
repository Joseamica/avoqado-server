import { NotificationType, NotificationPriority, NotificationChannel } from '@prisma/client'
import {
  shouldNotifyBadReview,
  getReviewContext,
  sendBadReviewNotifications,
  BadReviewContext,
} from '../../../../src/services/dashboard/badReviewNotification.service'

// Mock Prisma Client
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueSettings: {
      findUnique: jest.fn(),
    },
    payment: {
      findUnique: jest.fn(),
    },
    staffVenue: {
      findMany: jest.fn(),
    },
  },
}))

// Mock notification service
jest.mock('../../../../src/services/dashboard/notification.dashboard.service', () => ({
  sendVenueNotification: jest.fn().mockResolvedValue([
    { id: 'notif-1', recipientId: 'staff-1' },
    { id: 'notif-2', recipientId: 'staff-2' },
  ]),
}))

// Mock Resend
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ id: 'email-123' }),
    },
  })),
}))

// Mock logger
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { sendVenueNotification } from '../../../../src/services/dashboard/notification.dashboard.service'

describe('Bad Review Notification Service', () => {
  const mockVenueSettingsFindUnique = prisma.venueSettings.findUnique as jest.Mock
  const mockPaymentFindUnique = prisma.payment.findUnique as jest.Mock
  const mockStaffVenueFindMany = prisma.staffVenue.findMany as jest.Mock
  const mockSendVenueNotification = sendVenueNotification as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.RESEND_API_KEY = 'test-api-key'
    process.env.FRONTEND_URL = 'https://test.avoqado.io'
  })

  describe('shouldNotifyBadReview', () => {
    it('should return shouldNotify=true for rating below threshold (threshold=3, rating=2)', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: true,
        badReviewThreshold: 3,
        badReviewAlertRoles: ['OWNER', 'ADMIN', 'MANAGER'],
      })

      // Act
      const result = await shouldNotifyBadReview('venue-123', 2)

      // Assert
      expect(result.shouldNotify).toBe(true)
      expect(result.threshold).toBe(3)
      expect(result.alertRoles).toEqual(['OWNER', 'ADMIN', 'MANAGER'])
    })

    it('should return shouldNotify=true for rating equal to threshold (threshold=3, rating=3)', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: true,
        badReviewThreshold: 3,
        badReviewAlertRoles: ['OWNER', 'ADMIN'],
      })

      // Act
      const result = await shouldNotifyBadReview('venue-123', 3)

      // Assert
      expect(result.shouldNotify).toBe(true)
    })

    it('should return shouldNotify=false for rating above threshold (threshold=3, rating=4)', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: true,
        badReviewThreshold: 3,
        badReviewAlertRoles: ['OWNER', 'ADMIN', 'MANAGER'],
      })

      // Act
      const result = await shouldNotifyBadReview('venue-123', 4)

      // Assert
      expect(result.shouldNotify).toBe(false)
    })

    it('should return shouldNotify=false when notifications are disabled', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: false,
        badReviewThreshold: 3,
        badReviewAlertRoles: ['OWNER', 'ADMIN', 'MANAGER'],
      })

      // Act
      const result = await shouldNotifyBadReview('venue-123', 1)

      // Assert
      expect(result.shouldNotify).toBe(false)
    })

    it('should use default settings when venue settings not found', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue(null)

      // Act
      const result = await shouldNotifyBadReview('venue-123', 2)

      // Assert
      expect(result.shouldNotify).toBe(true) // default notifyBadReviews = true
      expect(result.threshold).toBe(3) // default threshold = 3
      expect(result.alertRoles).toEqual(['OWNER', 'ADMIN', 'MANAGER']) // default roles
    })

    it('should notify for 1-star rating with default threshold', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue(null)

      // Act
      const result = await shouldNotifyBadReview('venue-123', 1)

      // Assert
      expect(result.shouldNotify).toBe(true)
    })

    it('should NOT notify for 5-star rating with default threshold', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue(null)

      // Act
      const result = await shouldNotifyBadReview('venue-123', 5)

      // Assert
      expect(result.shouldNotify).toBe(false)
    })

    it('should handle custom threshold (threshold=2, rating=3)', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: true,
        badReviewThreshold: 2,
        badReviewAlertRoles: ['OWNER'],
      })

      // Act
      const result = await shouldNotifyBadReview('venue-123', 3)

      // Assert
      expect(result.shouldNotify).toBe(false) // 3 > 2, no notification
    })

    it('should handle custom roles configuration', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: true,
        badReviewThreshold: 3,
        badReviewAlertRoles: ['OWNER', 'ADMIN', 'MANAGER', 'WAITER'],
      })

      // Act
      const result = await shouldNotifyBadReview('venue-123', 2)

      // Assert
      expect(result.alertRoles).toEqual(['OWNER', 'ADMIN', 'MANAGER', 'WAITER'])
    })
  })

  describe('getReviewContext', () => {
    it('should return full context when payment has all related data', async () => {
      // Arrange
      mockPaymentFindUnique.mockResolvedValue({
        id: 'payment-123',
        venue: {
          id: 'venue-123',
          name: 'Test Restaurant',
          slug: 'test-restaurant',
        },
        order: {
          id: 'order-456',
          orderNumber: 'ORD-001',
          table: {
            id: 'table-1',
            number: '5',
          },
          servedBy: {
            id: 'staff-waiter',
            firstName: 'Juan',
            lastName: 'Perez',
          },
        },
        processedBy: null,
      })

      // Act
      const result = await getReviewContext('payment-123', 'venue-123', 'review-789')

      // Assert
      expect(result).not.toBeNull()
      expect(result?.reviewId).toBe('review-789')
      expect(result?.venueId).toBe('venue-123')
      expect(result?.venueName).toBe('Test Restaurant')
      expect(result?.venueSlug).toBe('test-restaurant')
      expect(result?.tableNumber).toBe('5')
      expect(result?.orderNumber).toBe('ORD-001')
      expect(result?.orderId).toBe('order-456')
      expect(result?.waiterName).toBe('Juan Perez')
      expect(result?.waiterId).toBe('staff-waiter')
    })

    it('should use processedBy when servedBy is null', async () => {
      // Arrange
      mockPaymentFindUnique.mockResolvedValue({
        id: 'payment-123',
        venue: {
          id: 'venue-123',
          name: 'Test Restaurant',
          slug: 'test-restaurant',
        },
        order: {
          id: 'order-456',
          orderNumber: 'ORD-001',
          table: null,
          servedBy: null,
        },
        processedBy: {
          id: 'staff-cashier',
          firstName: 'Maria',
          lastName: 'Lopez',
        },
      })

      // Act
      const result = await getReviewContext('payment-123', 'venue-123', 'review-789')

      // Assert
      expect(result?.waiterName).toBe('Maria Lopez')
      expect(result?.waiterId).toBe('staff-cashier')
    })

    it('should return null when payment not found', async () => {
      // Arrange
      mockPaymentFindUnique.mockResolvedValue(null)

      // Act
      const result = await getReviewContext('invalid-payment', 'venue-123', 'review-789')

      // Assert
      expect(result).toBeNull()
    })

    it('should handle missing table information', async () => {
      // Arrange
      mockPaymentFindUnique.mockResolvedValue({
        id: 'payment-123',
        venue: {
          id: 'venue-123',
          name: 'Test Restaurant',
          slug: 'test-restaurant',
        },
        order: {
          id: 'order-456',
          orderNumber: 'ORD-001',
          table: null,
          servedBy: null,
        },
        processedBy: null,
      })

      // Act
      const result = await getReviewContext('payment-123', 'venue-123', 'review-789')

      // Assert
      expect(result?.tableNumber).toBeNull()
      expect(result?.waiterName).toBeNull()
      expect(result?.waiterId).toBeNull()
    })
  })

  describe('sendBadReviewNotifications', () => {
    const mockContext: BadReviewContext = {
      reviewId: 'review-123',
      venueId: 'venue-123',
      venueName: 'Test Restaurant',
      venueSlug: 'test-restaurant',
      rating: 2,
      comment: 'La comida estaba fria',
      customerName: 'Cliente Test',
      customerEmail: 'cliente@test.com',
      tableNumber: '5',
      orderNumber: 'ORD-001',
      orderId: 'order-456',
      waiterName: 'Juan Perez',
      waiterId: 'staff-waiter',
      foodRating: 2,
      serviceRating: 3,
      ambienceRating: 4,
    }

    beforeEach(() => {
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: true,
        badReviewThreshold: 3,
        badReviewAlertRoles: ['OWNER', 'ADMIN', 'MANAGER'],
      })

      mockStaffVenueFindMany.mockResolvedValue([
        { staff: { email: 'owner@test.com', firstName: 'Owner' } },
        { staff: { email: 'admin@test.com', firstName: 'Admin' } },
      ])
    })

    it('should send in-app notifications to staff with configured roles', async () => {
      // Act
      await sendBadReviewNotifications(mockContext)

      // Assert
      expect(mockSendVenueNotification).toHaveBeenCalledWith(
        'venue-123',
        expect.objectContaining({
          type: NotificationType.BAD_REVIEW,
          priority: NotificationPriority.HIGH,
          channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
          actionUrl: '/reviews?highlight=review-123',
          actionLabel: 'Ver Review',
          entityType: 'Review',
          entityId: 'review-123',
        }),
        ['OWNER', 'ADMIN', 'MANAGER'],
      )
    })

    it('should include rating information in notification title', async () => {
      // Act
      await sendBadReviewNotifications(mockContext)

      // Assert
      const callArgs = mockSendVenueNotification.mock.calls[0][1]
      expect(callArgs.title).toContain('Calificación baja')
      expect(callArgs.title).toContain('★★☆☆☆') // 2 stars filled, 3 empty
    })

    it('should include all context in notification metadata', async () => {
      // Act
      await sendBadReviewNotifications(mockContext)

      // Assert
      const callArgs = mockSendVenueNotification.mock.calls[0][1]
      expect(callArgs.metadata).toEqual(
        expect.objectContaining({
          rating: 2,
          tableNumber: '5',
          orderNumber: 'ORD-001',
          customerName: 'Cliente Test',
          waiterName: 'Juan Perez',
          comment: 'La comida estaba fria',
          foodRating: 2,
          serviceRating: 3,
          ambienceRating: 4,
        }),
      )
    })

    it('should send emails to staff with configured roles', async () => {
      // Act
      await sendBadReviewNotifications(mockContext)

      // Assert
      expect(mockStaffVenueFindMany).toHaveBeenCalledWith({
        where: {
          venueId: 'venue-123',
          active: true,
          role: {
            in: ['OWNER', 'ADMIN', 'MANAGER'],
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
    })

    it('should not throw error when notification sending fails', async () => {
      // Arrange
      mockSendVenueNotification.mockRejectedValue(new Error('Notification service error'))

      // Act & Assert - should not throw
      await expect(sendBadReviewNotifications(mockContext)).resolves.not.toThrow()
    })

    it('should handle context with minimal data', async () => {
      // Arrange
      const minimalContext: BadReviewContext = {
        reviewId: 'review-123',
        venueId: 'venue-123',
        venueName: 'Test Restaurant',
        venueSlug: 'test-restaurant',
        rating: 1,
        comment: null,
        customerName: null,
        customerEmail: null,
        tableNumber: null,
        orderNumber: null,
        orderId: null,
        waiterName: null,
        waiterId: null,
        foodRating: null,
        serviceRating: null,
        ambienceRating: null,
      }

      // Act
      await sendBadReviewNotifications(minimalContext)

      // Assert
      expect(mockSendVenueNotification).toHaveBeenCalled()
    })
  })

  describe('Notification message building', () => {
    beforeEach(() => {
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: true,
        badReviewThreshold: 3,
        badReviewAlertRoles: ['OWNER', 'ADMIN', 'MANAGER'],
      })

      mockStaffVenueFindMany.mockResolvedValue([])
    })

    it('should build message with table number when provided', async () => {
      // Arrange
      const context: BadReviewContext = {
        reviewId: 'review-123',
        venueId: 'venue-123',
        venueName: 'Test Restaurant',
        venueSlug: 'test-restaurant',
        rating: 2,
        tableNumber: '10',
        orderNumber: null,
        orderId: null,
        waiterName: null,
        waiterId: null,
        comment: null,
        customerName: null,
        customerEmail: null,
        foodRating: null,
        serviceRating: null,
        ambienceRating: null,
      }

      // Act
      await sendBadReviewNotifications(context)

      // Assert
      const callArgs = mockSendVenueNotification.mock.calls[0][1]
      expect(callArgs.message).toContain('Mesa: 10')
    })

    it('should build message with order number when provided', async () => {
      // Arrange
      const context: BadReviewContext = {
        reviewId: 'review-123',
        venueId: 'venue-123',
        venueName: 'Test Restaurant',
        venueSlug: 'test-restaurant',
        rating: 2,
        tableNumber: null,
        orderNumber: 'ORD-999',
        orderId: 'order-999',
        waiterName: null,
        waiterId: null,
        comment: null,
        customerName: null,
        customerEmail: null,
        foodRating: null,
        serviceRating: null,
        ambienceRating: null,
      }

      // Act
      await sendBadReviewNotifications(context)

      // Assert
      const callArgs = mockSendVenueNotification.mock.calls[0][1]
      expect(callArgs.message).toContain('Orden: #ORD-999')
    })

    it('should include sub-ratings in message when provided', async () => {
      // Arrange
      const context: BadReviewContext = {
        reviewId: 'review-123',
        venueId: 'venue-123',
        venueName: 'Test Restaurant',
        venueSlug: 'test-restaurant',
        rating: 2,
        tableNumber: null,
        orderNumber: null,
        orderId: null,
        waiterName: null,
        waiterId: null,
        comment: null,
        customerName: null,
        customerEmail: null,
        foodRating: 1,
        serviceRating: 2,
        ambienceRating: 3,
      }

      // Act
      await sendBadReviewNotifications(context)

      // Assert
      const callArgs = mockSendVenueNotification.mock.calls[0][1]
      expect(callArgs.message).toContain('Comida: 1/5')
      expect(callArgs.message).toContain('Servicio: 2/5')
      expect(callArgs.message).toContain('Ambiente: 3/5')
    })

    it('should include customer comment in message when provided', async () => {
      // Arrange
      const context: BadReviewContext = {
        reviewId: 'review-123',
        venueId: 'venue-123',
        venueName: 'Test Restaurant',
        venueSlug: 'test-restaurant',
        rating: 2,
        tableNumber: null,
        orderNumber: null,
        orderId: null,
        waiterName: null,
        waiterId: null,
        comment: 'Muy mala experiencia',
        customerName: null,
        customerEmail: null,
        foodRating: null,
        serviceRating: null,
        ambienceRating: null,
      }

      // Act
      await sendBadReviewNotifications(context)

      // Assert
      const callArgs = mockSendVenueNotification.mock.calls[0][1]
      expect(callArgs.message).toContain('Comentario: "Muy mala experiencia"')
    })
  })

  describe('Edge cases and regressions', () => {
    it('should handle venue with no staff configured for alert roles', async () => {
      // Arrange
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: true,
        badReviewThreshold: 3,
        badReviewAlertRoles: ['OWNER'],
      })

      mockStaffVenueFindMany.mockResolvedValue([]) // No staff found

      const context: BadReviewContext = {
        reviewId: 'review-123',
        venueId: 'venue-123',
        venueName: 'Test Restaurant',
        venueSlug: 'test-restaurant',
        rating: 2,
        tableNumber: null,
        orderNumber: null,
        orderId: null,
        waiterName: null,
        waiterId: null,
        comment: null,
        customerName: null,
        customerEmail: null,
        foodRating: null,
        serviceRating: null,
        ambienceRating: null,
      }

      // Act & Assert - should not throw
      await expect(sendBadReviewNotifications(context)).resolves.not.toThrow()
    })

    it('should correctly generate star display for each rating', async () => {
      // This test verifies the star generation logic
      mockVenueSettingsFindUnique.mockResolvedValue({
        notifyBadReviews: true,
        badReviewThreshold: 5,
        badReviewAlertRoles: ['OWNER'],
      })
      mockStaffVenueFindMany.mockResolvedValue([])

      const testCases = [
        { rating: 1, expectedStars: '★☆☆☆☆' },
        { rating: 2, expectedStars: '★★☆☆☆' },
        { rating: 3, expectedStars: '★★★☆☆' },
        { rating: 4, expectedStars: '★★★★☆' },
        { rating: 5, expectedStars: '★★★★★' },
      ]

      for (const { rating, expectedStars } of testCases) {
        const context: BadReviewContext = {
          reviewId: 'review-123',
          venueId: 'venue-123',
          venueName: 'Test',
          venueSlug: 'test',
          rating,
          tableNumber: null,
          orderNumber: null,
          orderId: null,
          waiterName: null,
          waiterId: null,
          comment: null,
          customerName: null,
          customerEmail: null,
          foodRating: null,
          serviceRating: null,
          ambienceRating: null,
        }

        await sendBadReviewNotifications(context)

        const callArgs = mockSendVenueNotification.mock.calls[mockSendVenueNotification.mock.calls.length - 1][1]
        expect(callArgs.title).toContain(expectedStars)
      }
    })
  })
})
