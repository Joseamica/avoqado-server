// Override the global setup mock so we test the real implementation.
jest.unmock('@/services/dashboard/activity-log.service')

import { queryVenueActivityLogs } from '../../../../src/services/dashboard/activity-log.service'
import prisma from '../../../../src/utils/prismaClient'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    activityLog: { count: jest.fn(), findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
  },
}))

const mockPrisma = prisma as unknown as {
  activityLog: { count: jest.Mock; findMany: jest.Mock }
  venue: { findUnique: jest.Mock }
}

describe('queryVenueActivityLogs', () => {
  beforeEach(() => jest.clearAllMocks())

  it('scopes the query to exactly one venueId and paginates', async () => {
    mockPrisma.venue.findUnique.mockResolvedValue({ id: 'v1', name: 'Sucursal Centro' })
    mockPrisma.activityLog.count.mockResolvedValue(1)
    mockPrisma.activityLog.findMany.mockResolvedValue([
      { id: 'a1', action: 'ITEM_VOIDED', entity: 'Order', entityId: 'o1', data: {}, ipAddress: null, createdAt: new Date(), staff: null, venueId: 'v1' },
    ])

    const result = await queryVenueActivityLogs({ venueId: 'v1', page: 1, pageSize: 25 })

    const whereArg = mockPrisma.activityLog.findMany.mock.calls[0][0].where
    expect(whereArg.venueId).toBe('v1')
    expect(result.logs[0].venueName).toBe('Sucursal Centro')
    expect(result.pagination.total).toBe(1)
  })

  it('applies action + date filters when provided', async () => {
    mockPrisma.venue.findUnique.mockResolvedValue({ id: 'v1', name: 'X' })
    mockPrisma.activityLog.count.mockResolvedValue(0)
    mockPrisma.activityLog.findMany.mockResolvedValue([])

    await queryVenueActivityLogs({ venueId: 'v1', action: 'PAYMENT_COMPLETED', startDate: '2026-06-01', endDate: '2026-06-15' })

    const whereArg = mockPrisma.activityLog.findMany.mock.calls[0][0].where
    expect(whereArg.action).toBe('PAYMENT_COMPLETED')
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date)
    expect(whereArg.createdAt.lte).toBeInstanceOf(Date)
  })

  it('returns empty result when the venue does not exist', async () => {
    mockPrisma.venue.findUnique.mockResolvedValue(null)
    const result = await queryVenueActivityLogs({ venueId: 'nope' })
    expect(result.logs).toEqual([])
    expect(result.pagination.total).toBe(0)
  })
})
