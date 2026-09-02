import { prismaMock } from '../../../__helpers__/setup'
import { stockDashboardService } from '@/services/stock-dashboard/stockDashboard.service'

describe('StockDashboardService.getRecentMovements', () => {
  it('acota solicitudes heredadas grandes antes de consultar SerializedItem', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
    prismaMock.serializedItem.findMany.mockResolvedValue([])

    await stockDashboardService.getRecentMovements('venue-1', 500)

    expect(prismaMock.serializedItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 101,
      }),
    )
  })

  it('pagina en bloques acotados para que el frontend pueda cargar el historial', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
    prismaMock.serializedItem.findMany.mockResolvedValue([])

    await stockDashboardService.getRecentMovements('venue-1', 100, { page: 3 })

    expect(prismaMock.serializedItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 200,
        take: 101,
      }),
    )
  })

  it('no pierde eventos cuando un mismo item produce registro y venta', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
    prismaMock.serializedItem.findMany.mockResolvedValue([
      {
        id: 'sim-1',
        serialNumber: '8952140000000000001',
        status: 'SOLD',
        categoryId: 'cat-1',
        category: { name: 'SIM 5G' },
        createdAt: new Date('2026-08-31T18:00:00.000Z'),
        soldAt: new Date('2026-09-01T12:00:00.000Z'),
        venueId: 'venue-1',
        venue: { name: 'Sucursal Centro' },
        sellingVenue: { name: 'Sucursal Centro' },
        registeredFromVenueId: 'venue-1',
        registeredFromVenue: { name: 'Sucursal Centro' },
        createdBy: null,
        assignedPromoterId: null,
        assignedSupervisorId: null,
        custodyState: 'SOLD',
        orderItem: null,
      } as any,
    ])

    const result = await stockDashboardService.getRecentMovementsPage('venue-1', 1)

    expect(prismaMock.serializedItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 2,
      }),
    )
    expect(result.movements.map(movement => movement.type)).toEqual(['SOLD', 'REGISTERED'])
    expect(result.hasMore).toBe(false)
  })
})
