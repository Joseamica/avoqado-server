import { prismaMock } from '../../../__helpers__/setup'
import { orgStockControlService } from '@/services/organization-dashboard/orgStockControl.service'

describe('OrgStockControlService.getOrgBulkGroupsPage', () => {
  it('pagina cargas completas y busca ICCID dentro del grupo sin devolver todos sus seriales', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ total: 37 }]).mockResolvedValueOnce([
      {
        id: 'bulk-sim-100',
        firstCreatedAt: new Date('2026-08-31T18:00:00.000Z'),
        lastCreatedAt: new Date('2026-08-31T18:01:00.000Z'),
        categoryId: 'cat-1',
        categoryName: 'SIM 5G',
        registeredFromVenueId: 'venue-1',
        registeredFromVenueName: 'Sucursal Centro',
        createdById: 'staff-1',
        createdByName: 'Ana López',
        createdByEmployeeCode: 'A-7',
        itemCount: 100,
        serialNumberFirst: '8952140000000000001',
        serialNumberLast: '8952140000000000100',
        availableCount: 80,
        soldCount: 18,
        damagedCount: 1,
        returnedCount: 1,
      },
    ])

    const result = await orgStockControlService.getOrgBulkGroupsPage('org-1', {
      dateFrom: new Date('2025-09-01T00:00:00.000Z'),
      dateTo: new Date('2026-09-01T23:59:59.999Z'),
      page: 2,
      pageSize: 20,
      search: '895214',
      categoryId: 'cat-1',
      registeredFromVenueId: 'venue-1',
    })

    expect(prismaMock.serializedItem.findMany).not.toHaveBeenCalled()
    expect(result).toEqual({
      groups: [
        {
          id: 'bulk-sim-100',
          firstCreatedAt: '2026-08-31T18:00:00.000Z',
          lastCreatedAt: '2026-08-31T18:01:00.000Z',
          categoryId: 'cat-1',
          categoryName: 'SIM 5G',
          registeredFromVenueId: 'venue-1',
          registeredFromVenueName: 'Sucursal Centro',
          createdById: 'staff-1',
          createdByName: 'Ana López',
          createdByEmployeeCode: 'A-7',
          itemCount: 100,
          serialNumberFirst: '8952140000000000001',
          serialNumberLast: '8952140000000000100',
          availableCount: 80,
          soldCount: 18,
          damagedCount: 1,
          returnedCount: 1,
        },
      ],
      pagination: { page: 2, pageSize: 20, total: 37, totalPages: 2 },
    })
  })
})
