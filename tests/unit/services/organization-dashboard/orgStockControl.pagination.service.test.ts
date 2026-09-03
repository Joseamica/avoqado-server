import { prismaMock } from '../../../__helpers__/setup'
import { orgStockControlService } from '@/services/organization-dashboard/orgStockControl.service'

describe('OrgStockControlService.getOrgItemsPage', () => {
  it('pagina y filtra en la base de datos sin cargar el inventario completo', async () => {
    const createdAt = new Date('2026-08-31T18:00:00.000Z')

    prismaMock.serializedItem.count.mockResolvedValue(205)
    prismaMock.serializedItem.findMany.mockResolvedValue([
      {
        id: 'sim-3',
        serialNumber: '8952140000000000003',
        status: 'AVAILABLE',
        categoryId: 'cat-1',
        category: { id: 'cat-1', name: 'SIM 5G' },
        createdAt,
        soldAt: null,
        registeredFromVenueId: 'venue-1',
        registeredFromVenue: { id: 'venue-1', name: 'Sucursal Centro' },
        sellingVenueId: null,
        sellingVenue: null,
        venueId: 'venue-1',
        venue: { id: 'venue-1', name: 'Sucursal Centro' },
        createdBy: 'staff-1',
        custodyState: 'ADMIN_HELD',
        assignedSupervisorId: null,
        assignedSupervisor: null,
        assignedPromoterId: null,
        assignedPromoter: null,
        promoterAcceptedAt: null,
        promoterRejectedAt: null,
      },
    ])
    prismaMock.staff.findMany.mockResolvedValue([{ id: 'staff-1', firstName: 'Ana', lastName: 'López', employeeCode: 'A-7' }])

    const result = await orgStockControlService.getOrgItemsPage('org-1', {
      dateFrom: new Date('2025-09-01T00:00:00.000Z'),
      dateTo: new Date('2026-09-01T23:59:59.999Z'),
      page: 2,
      pageSize: 50,
      search: '895214',
      status: 'AVAILABLE',
      categoryId: 'cat-1',
      registeredFromVenueId: 'venue-1',
      custodyState: 'PROMOTER_HELD',
    })

    expect(prismaMock.serializedItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          serialNumber: { contains: '895214' },
          status: 'AVAILABLE',
          categoryId: 'cat-1',
          registeredFromVenueId: 'venue-1',
          custodyState: 'PROMOTER_HELD',
        }),
        skip: 50,
        take: 50,
      }),
    )
    expect(result).toMatchObject({
      items: [
        {
          id: 'sim-3',
          serialNumber: '8952140000000000003',
          createdByName: 'Ana López',
          createdByEmployeeCode: 'A-7',
        },
      ],
      pagination: {
        page: 2,
        pageSize: 50,
        total: 205,
        totalPages: 5,
      },
    })
  })

  it('acepta varios estados de custodia para los selectores operativos', async () => {
    prismaMock.serializedItem.count.mockResolvedValue(0)
    prismaMock.serializedItem.findMany.mockResolvedValue([])

    await orgStockControlService.getOrgItemsPage('org-1', {
      page: 1,
      pageSize: 100,
      custodyStates: ['PROMOTER_HELD', 'PROMOTER_PENDING'],
    })

    expect(prismaMock.serializedItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ custodyState: { in: ['PROMOTER_HELD', 'PROMOTER_PENDING'] } }),
      }),
    )
  })
})
