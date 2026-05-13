import prisma from '@/utils/prismaClient'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import * as availableBalanceService from '@/services/dashboard/availableBalance.dashboard.service'

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
})
