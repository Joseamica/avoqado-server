import prisma from '@/utils/prismaClient'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import * as availableBalanceService from '@/services/dashboard/availableBalance.dashboard.service'
import * as paymentLinkService from '@/services/dashboard/paymentLink.service'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: {
      findMany: jest.fn(),
    },
    venue: {
      findUnique: jest.fn(),
    },
  },
}))

jest.mock('@/services/dashboard/availableBalance.dashboard.service', () => ({
  getSettlementCalendar: jest.fn(),
}))

jest.mock('@/services/dashboard/paymentLink.service', () => ({
  getPaymentLinks: jest.fn(),
}))

jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  getReservationStats: jest.fn(),
  getReservations: jest.fn(),
}))

describe('SharedQueryService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('getPendingOrders', () => {
    it('only counts recently-created open orders as active', async () => {
      ;(prisma.order.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'order-recent',
          status: 'PENDING',
          createdAt: new Date('2026-05-11T23:30:00.000Z'),
        },
      ])

      const result = await SharedQueryService.getPendingOrders('venue-test')

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venueId: 'venue-test',
            status: { in: ['PENDING', 'CONFIRMED', 'PREPARING', 'READY'] },
            createdAt: { gte: new Date('2026-05-11T00:00:00.000Z') },
          }),
        }),
      )
      expect(result.total).toBe(1)
      expect(result.byStatus.pending).toBe(1)
      expect(result.averageWaitMinutes).toBe(30)
      expect(result.oldestOrderMinutes).toBe(30)
    })
  })

  describe('getSettlementCalendarForPeriod', () => {
    it('uses the available-balance settlement calendar as source of truth', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC', currency: 'MXN' })
      ;(availableBalanceService.getSettlementCalendar as jest.Mock).mockResolvedValue([
        {
          settlementDate: new Date('2026-05-12T12:00:00.000Z'),
          totalNetAmount: 1000,
          transactionCount: 2,
          status: 'PENDING',
          byCardType: [{ cardType: 'DEBIT', netAmount: 1000, transactionCount: 2 }],
        },
        {
          settlementDate: new Date('2026-05-12T18:00:00.000Z'),
          totalNetAmount: 250.5,
          transactionCount: 1,
          status: 'PENDING',
          byCardType: [{ cardType: 'CREDIT', netAmount: 250.5, transactionCount: 1 }],
        },
      ])

      const result = await SharedQueryService.getSettlementCalendarForPeriod('venue-test', 'today')

      expect(availableBalanceService.getSettlementCalendar).toHaveBeenCalledWith('venue-test', {
        from: new Date('2026-05-12T00:00:00.000Z'),
        to: new Date('2026-05-12T23:59:59.999Z'),
      })
      expect(result.totalNetAmount).toBe(1250.5)
      expect(result.transactionCount).toBe(3)
      expect(result.currency).toBe('MXN')
      expect(result.entries).toHaveLength(2)
    })
  })

  describe('getPaymentLinks', () => {
    it('uses the dashboard payment link service as source of truth', async () => {
      ;(paymentLinkService.getPaymentLinks as jest.Mock).mockResolvedValue({
        total: 1,
        limit: 10,
        offset: 0,
        hasMore: false,
        paymentLinks: [
          {
            id: 'pl-1',
            title: 'Cena privada',
            shortCode: 'abc12345',
            status: 'ACTIVE',
            purpose: 'PAYMENT',
            amountType: 'FIXED',
            amount: 500,
            currency: 'MXN',
            isReusable: true,
            totalCollected: 1000,
            paymentCount: 2,
            createdAt: new Date('2026-05-12T12:00:00.000Z'),
            expiresAt: null,
            createdBy: { firstName: 'Ana', lastName: 'Admin' },
            _count: { checkoutSessions: 3 },
          },
        ],
      })

      const result = await SharedQueryService.getPaymentLinks('venue-test', { limit: 10, status: 'ACTIVE' })

      expect(paymentLinkService.getPaymentLinks).toHaveBeenCalledWith('venue-test', {
        status: 'ACTIVE',
        search: undefined,
        limit: 10,
        offset: undefined,
      })
      expect(result.links).toEqual([
        expect.objectContaining({
          title: 'Cena privada',
          amount: 500,
          totalCollected: 1000,
          paymentCount: 2,
          checkoutSessionCount: 3,
          createdByName: 'Ana Admin',
        }),
      ])
    })
  })

  describe('getReservationSummary', () => {
    it('uses the dashboard reservation stats service as source of truth', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC' })
      ;(reservationService.getReservationStats as jest.Mock).mockResolvedValue({
        total: 3,
        byStatus: { CONFIRMED: 2, PENDING: 1 },
        byChannel: { WEB: 2, PHONE: 1 },
        noShowRate: 0,
      })

      const result = await SharedQueryService.getReservationSummary('venue-test', 'today')

      expect(reservationService.getReservationStats).toHaveBeenCalledWith(
        'venue-test',
        new Date('2026-05-12T00:00:00.000Z'),
        new Date('2026-05-12T23:59:59.999Z'),
      )
      expect(result).toEqual(
        expect.objectContaining({
          total: 3,
          byStatus: { CONFIRMED: 2, PENDING: 1 },
          period: 'today',
        }),
      )
    })
  })

  describe('getReservations', () => {
    it('uses the dashboard reservation list service and removes sensitive fields from the summary', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'UTC' })
      ;(reservationService.getReservations as jest.Mock).mockResolvedValue({
        data: [
          {
            confirmationCode: 'RES-ABC123',
            status: 'CONFIRMED',
            channel: 'WEB',
            startsAt: new Date('2026-05-12T20:00:00.000Z'),
            endsAt: new Date('2026-05-12T21:00:00.000Z'),
            partySize: 4,
            guestName: 'Mesa Perez',
            guestPhone: '+525500000000',
            guestEmail: 'guest@example.com',
            internalNotes: 'VIP',
            cancelSecret: 'secret',
            customer: { firstName: 'Ana', lastName: 'Perez', phone: '+525511111111', email: 'ana@example.com' },
            table: { number: '12' },
            product: { name: 'Cena' },
            assignedStaff: { firstName: 'Luis', lastName: 'Host' },
          },
        ],
        meta: { total: 1, page: 1, pageSize: 10, totalPages: 1 },
      })

      const result = await SharedQueryService.getReservations('venue-test', 'today', { limit: 10, status: 'confirmed' })

      expect(reservationService.getReservations).toHaveBeenCalledWith(
        'venue-test',
        {
          dateFrom: new Date('2026-05-12T00:00:00.000Z'),
          dateTo: new Date('2026-05-12T23:59:59.999Z'),
          status: 'CONFIRMED',
          search: undefined,
        },
        1,
        10,
      )
      expect(result.reservations).toEqual([
        {
          confirmationCode: 'RES-ABC123',
          status: 'CONFIRMED',
          channel: 'WEB',
          startsAt: new Date('2026-05-12T20:00:00.000Z'),
          endsAt: new Date('2026-05-12T21:00:00.000Z'),
          partySize: 4,
          guestName: 'Mesa Perez',
          customerName: 'Ana Perez',
          tableNumber: '12',
          productName: 'Cena',
          assignedStaffName: 'Luis Host',
        },
      ])
      expect(JSON.stringify(result)).not.toContain('guest@example.com')
      expect(JSON.stringify(result)).not.toContain('+525500000000')
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(JSON.stringify(result)).not.toContain('VIP')
    })
  })
})
