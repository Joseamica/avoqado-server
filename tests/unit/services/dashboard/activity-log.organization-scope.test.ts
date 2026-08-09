/**
 * Organization ActivityLog scope for H1A.
 *
 * A populated organizationId is authoritative; venue fallback exists only for
 * unclassified legacy rows. Search and filters must never replace that tenant
 * predicate.
 */
jest.unmock('@/services/dashboard/activity-log.service')

import {
  buildOrganizationActivityLogWhere,
  getDistinctActions,
  logAction,
  queryActivityLogs,
} from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    activityLog: { findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
    venue: { findMany: jest.fn(), findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const mockPrisma = prisma as unknown as {
  activityLog: { findMany: jest.Mock; count: jest.Mock; create: jest.Mock }
  venue: { findMany: jest.Mock; findUnique: jest.Mock }
}
const mockLogger = logger as unknown as { error: jest.Mock }

const ORGANIZATION_ID = 'org-pits'
const VENUE_IDS = ['venue-1', 'venue-2']

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.venue.findMany.mockResolvedValue(VENUE_IDS.map((id, index) => ({ id, name: `Venue ${index + 1}` })))
  mockPrisma.activityLog.count.mockResolvedValue(0)
  mockPrisma.activityLog.findMany.mockResolvedValue([])
})

describe('buildOrganizationActivityLogWhere', () => {
  it('nests tenant scope, scalar filters, and search in separate AND groups', () => {
    const where = buildOrganizationActivityLogWhere(
      {
        organizationId: ORGANIZATION_ID,
        venueId: 'venue-1',
        staffId: 'staff-1',
        action: 'CATALOG_ITEM_UPDATED',
        entity: 'CatalogItem',
        search: 'sku-001',
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-08-08T23:59:59.999Z',
      },
      VENUE_IDS,
    )

    expect(where).toEqual({
      AND: [
        {
          OR: [{ organizationId: ORGANIZATION_ID }, { organizationId: null, venueId: { in: VENUE_IDS } }],
        },
        { venueId: 'venue-1' },
        { venueId: { in: VENUE_IDS } },
        { staffId: 'staff-1' },
        { action: 'CATALOG_ITEM_UPDATED' },
        { entity: 'CatalogItem' },
        {
          OR: [
            { action: { contains: 'sku-001', mode: 'insensitive' } },
            { entity: { contains: 'sku-001', mode: 'insensitive' } },
            { entityId: { contains: 'sku-001', mode: 'insensitive' } },
          ],
        },
        {
          createdAt: {
            gte: new Date('2026-08-01T00:00:00.000Z'),
            lte: new Date('2026-08-08T23:59:59.999Z'),
          },
        },
      ],
    })
  })

  it('keeps an organization-only branch when the organization has zero venues', () => {
    expect(buildOrganizationActivityLogWhere({ organizationId: ORGANIZATION_ID }, [])).toEqual({
      AND: [
        {
          OR: [{ organizationId: ORGANIZATION_ID }, { organizationId: null, venueId: { in: [] } }],
        },
      ],
    })
  })
})

describe('organization ActivityLog queries', () => {
  it('reuses one identical scoped where for count and page query with stable ordering', async () => {
    await queryActivityLogs({ organizationId: ORGANIZATION_ID, search: 'publish', page: 2, pageSize: 10 })

    const countWhere = mockPrisma.activityLog.count.mock.calls[0][0].where
    const pageCall = mockPrisma.activityLog.findMany.mock.calls[0][0]
    expect(pageCall.where).toEqual(countWhere)
    expect(pageCall.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(pageCall.skip).toBe(10)
    expect(pageCall.take).toBe(10)
  })

  it('queries and returns organization-only rows even when the organization has zero venues', async () => {
    mockPrisma.venue.findMany.mockResolvedValue([])
    mockPrisma.activityLog.count.mockResolvedValue(1)
    mockPrisma.activityLog.findMany.mockResolvedValue([
      {
        id: 'activity-org-only',
        action: 'CATALOG_ITEM_CREATED',
        entity: 'CatalogItem',
        entityId: 'item-1',
        data: null,
        ipAddress: null,
        createdAt: new Date('2026-08-08T18:00:00.000Z'),
        staff: null,
        venueId: null,
      },
    ])

    const result = await queryActivityLogs({ organizationId: ORGANIZATION_ID })

    expect(mockPrisma.activityLog.findMany).toHaveBeenCalledTimes(1)
    expect(result.logs).toEqual([expect.objectContaining({ id: 'activity-org-only', venueName: 'Organization' })])
    expect(result.pagination.total).toBe(1)
  })

  it('uses the same authoritative tenant predicate for distinct actions, including zero venues', async () => {
    mockPrisma.venue.findMany.mockResolvedValue([])
    mockPrisma.activityLog.findMany.mockResolvedValue([{ action: 'CATALOG_ITEM_CREATED' }])

    await expect(getDistinctActions(ORGANIZATION_ID)).resolves.toEqual(['CATALOG_ITEM_CREATED'])
    expect(mockPrisma.activityLog.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ organizationId: ORGANIZATION_ID }, { organizationId: null, venueId: { in: [] } }],
      },
      select: { action: true },
      distinct: ['action'],
      orderBy: { action: 'asc' },
    })
  })
})

describe('legacy logAction compatibility', () => {
  it('remains best-effort and resolves when its global ActivityLog insert fails', async () => {
    mockPrisma.activityLog.create.mockRejectedValue(new Error('legacy audit unavailable'))

    await expect(
      logAction({ staffId: 'staff-legacy', venueId: 'venue-1', action: 'LEGACY_ACTION', entity: 'LegacyEntity' }),
    ).resolves.toBeUndefined()

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[ActivityLog] Failed to write audit log',
      expect.objectContaining({ action: 'LEGACY_ACTION', entity: 'LegacyEntity' }),
    )
  })
})
