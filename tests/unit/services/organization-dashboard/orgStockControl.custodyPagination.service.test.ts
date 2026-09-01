import { prismaMock } from '../../../__helpers__/setup'
import { orgStockControlService } from '@/services/organization-dashboard/orgStockControl.service'

describe('OrgStockControlService.getOrgCustodyPage', () => {
  it('agrega la custodia completa y solo hidrata una pagina del supervisor', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([{ venueId: 'venue-managed' }] as any)
    prismaMock.serializedItem.groupBy.mockResolvedValue([
      { status: 'AVAILABLE', custodyState: 'SUPERVISOR_HELD', assignedPromoterId: null, _count: { _all: 3 } },
      { status: 'AVAILABLE', custodyState: 'PROMOTER_PENDING', assignedPromoterId: 'promoter-1', _count: { _all: 2 } },
      { status: 'SOLD', custodyState: 'SOLD', assignedPromoterId: 'promoter-1', _count: { _all: 4 } },
    ] as any)
    prismaMock.serializedItem.count.mockResolvedValueOnce(1).mockResolvedValueOnce(9)
    prismaMock.serializedItem.findMany.mockResolvedValue([])
    prismaMock.staff.findMany.mockResolvedValue([{ id: 'promoter-1', firstName: 'Luz', lastName: 'Díaz' }] as any)

    const result = await orgStockControlService.getOrgCustodyPage(
      'org-1',
      'supervisor-1',
      {
        targetVenueId: 'venue-current',
        dateFrom: new Date('2025-09-01T00:00:00.000Z'),
        dateTo: new Date('2026-09-01T23:59:59.999Z'),
        page: 2,
        pageSize: 50,
        search: '895214',
        filter: 'pendientes',
      },
      new Date('2026-09-01T20:00:00.000Z'),
    )

    expect(prismaMock.serializedItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['status', 'custodyState', 'assignedPromoterId'],
        where: expect.objectContaining({
          organizationId: 'org-1',
          OR: [
            { assignedSupervisorId: 'supervisor-1' },
            {
              registeredFromVenueId: { in: ['venue-current', 'venue-managed'] },
              assignedPromoterId: { not: null },
            },
          ],
        }),
      }),
    )
    expect(prismaMock.serializedItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          serialNumber: { contains: '895214' },
          custodyState: 'PROMOTER_PENDING',
        }),
        skip: 50,
        take: 50,
      }),
    )
    expect(result).toMatchObject({
      summary: {
        total: 9,
        almacen: 3,
        pendientes: 2,
        aceptados: 0,
        rechazados: 0,
        vendidos: 4,
        estancados: 1,
      },
      promoterRanking: [{ id: 'promoter-1', name: 'Luz Díaz', pending: 2, held: 0, sold: 4 }],
      pagination: { page: 2, pageSize: 50, total: 9, totalPages: 1 },
    })
  })
})
