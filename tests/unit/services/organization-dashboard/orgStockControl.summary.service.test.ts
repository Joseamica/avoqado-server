import { prismaMock } from '../../../__helpers__/setup'
import { orgStockControlService } from '@/services/organization-dashboard/orgStockControl.service'

describe('OrgStockControlService.getOrgSummary', () => {
  it('conserva totales globales usando agregaciones sin materializar todas las SIMs', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          totalSims: 205,
          available: 120,
          sold: 75,
          damaged: 6,
          returned: 4,
          totalCargas: 9,
          sucursalesInvolucradas: 2,
          categoriasActivas: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          venueId: 'venue-1',
          venueName: 'Sucursal Centro',
          totalSims: 205,
          available: 120,
          sold: 75,
          damaged: 6,
          returned: 4,
          soldDay0: 1,
          soldDay1: 2,
          soldDay2: 3,
          soldDay3: 4,
          soldDay4: 5,
          soldDay5: 6,
          soldDay6: 7,
          lastActivity: new Date('2026-09-01T12:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          categoryId: 'cat-1',
          categoryName: 'SIM 5G',
          totalSims: 205,
          available: 120,
          sold: 75,
          sucursalesConStock: 2,
        },
      ])

    prismaMock.serializedItem.findFirst
      .mockResolvedValueOnce({
        createdAt: new Date('2026-09-01T11:00:00.000Z'),
        registeredFromVenue: { name: 'Sucursal Centro' },
      })
      .mockResolvedValueOnce({
        soldAt: new Date('2026-09-01T12:00:00.000Z'),
        sellingVenue: { name: 'Sucursal Centro' },
      })

    const result = await orgStockControlService.getOrgSummary(
      'org-1',
      {
        dateFrom: new Date('2025-09-01T00:00:00.000Z'),
        dateTo: new Date('2026-09-01T23:59:59.999Z'),
      },
      new Date('2026-09-01T18:00:00.000Z'),
    )

    expect(prismaMock.serializedItem.findMany).not.toHaveBeenCalled()
    expect(result.summary).toMatchObject({
      totalSims: 205,
      available: 120,
      sold: 75,
      damaged: 6,
      returned: 4,
      rotacionPct: 36.59,
      totalCargas: 9,
      sucursalesInvolucradas: 2,
      categoriasActivas: 1,
      lastActivity: {
        timestamp: '2026-09-01T12:00:00.000Z',
        venueName: 'Sucursal Centro',
        action: 'SALE',
      },
    })
    expect(result.aggregatesBySucursal[0]).toMatchObject({
      venueId: 'venue-1',
      totalSims: 205,
      rotacionPct: 36.59,
      salesLast7Days: [1, 2, 3, 4, 5, 6, 7],
    })
    expect(result.aggregatesByCategoria[0]).toMatchObject({
      categoryId: 'cat-1',
      totalSims: 205,
      rotacionPct: 36.59,
      pctOfTotal: 100,
      sucursalesConStock: 2,
    })
  })
})
