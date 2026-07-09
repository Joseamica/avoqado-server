const mockItemFindMany = jest.fn()
const mockItemCount = jest.fn()
const mockItemGroupBy = jest.fn()
const mockCategoryFindMany = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    serializedItem: {
      findMany: (...a: unknown[]) => mockItemFindMany(...(a as [])),
      count: (...a: unknown[]) => mockItemCount(...(a as [])),
      groupBy: (...a: unknown[]) => mockItemGroupBy(...(a as [])),
    },
    itemCategory: { findMany: (...a: unknown[]) => mockCategoryFindMany(...(a as [])) },
  },
}))

import { serializedInventoryService } from '../../../src/services/serialized-inventory/serializedInventory.service'

beforeEach(() => jest.clearAllMocks())

describe('listOrgItems — includes org-level pool (venueId=null)', () => {
  it('scopes by OR[venueId in allowed, organizationId] so venueId=null items are returned', async () => {
    mockItemFindMany.mockResolvedValue([
      { id: 'i1', serialNumber: 'ICC1', venueId: null, status: 'AVAILABLE', category: { name: 'SIM de Evento' } },
    ])
    mockItemCount.mockResolvedValue(1)
    const res = await serializedInventoryService.listOrgItems({ orgId: 'o1', allowedVenueIds: ['v1'], status: 'AVAILABLE', take: 50 })
    expect(res.total).toBe(1)
    expect(res.items[0].venueId).toBeNull()
    const whereArg = (mockItemFindMany.mock.calls[0][0] as any).where
    expect(whereArg.OR).toEqual([{ venueId: { in: ['v1'] } }, { organizationId: 'o1' }])
    expect(whereArg.status).toBe('AVAILABLE')
  })
})

describe('getOrgStockByCategory — org pool per category', () => {
  it('returns available/sold per org category', async () => {
    mockCategoryFindMany.mockResolvedValue([{ id: 'c1', name: 'SIM de Evento' }])
    mockItemGroupBy.mockResolvedValue([
      { categoryId: 'c1', status: 'AVAILABLE', _count: 4 },
      { categoryId: 'c1', status: 'SOLD', _count: 1 },
    ])
    const res = await serializedInventoryService.getOrgStockByCategory('o1', ['v1'])
    expect(res).toEqual([{ category: { id: 'c1', name: 'SIM de Evento' }, available: 4, sold: 1 }])
    const gbWhere = (mockItemGroupBy.mock.calls[0][0] as any).where
    expect(gbWhere.OR).toEqual([{ venueId: { in: ['v1'] } }, { organizationId: 'o1' }])
  })
})
