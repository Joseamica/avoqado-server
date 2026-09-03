import { prismaMock } from '../../../__helpers__/setup'
import { stockDashboardService } from '@/services/stock-dashboard/stockDashboard.service'

describe('StockDashboardService.getRecentMovements', () => {
  beforeEach(() => {
    ;(prismaMock.$queryRaw as jest.Mock).mockReset()
    prismaMock.serializedItem.findMany.mockReset()
    prismaMock.staff.findMany.mockReset()
  })

  it('acota solicitudes heredadas grandes antes de consultar SerializedItem', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])

    await stockDashboardService.getRecentMovements('venue-1', 500)

    const query = (prismaMock.$queryRaw as jest.Mock).mock.calls[0][0]
    expect(query.values).toContain(101)
    expect(prismaMock.serializedItem.findMany).not.toHaveBeenCalled()
  })

  it('pagina en bloques acotados para que el frontend pueda cargar el historial', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])

    await stockDashboardService.getRecentMovements('venue-1', 100, { page: 3 })

    const query = (prismaMock.$queryRaw as jest.Mock).mock.calls[0][0]
    expect(query.values).toEqual(expect.arrayContaining([101, 200]))
  })

  it('no pierde eventos cuando un mismo item produce registro y venta', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
    const soldItem = {
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
    } as any
    ;(prismaMock.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([
        { itemId: 'sim-1', eventType: 'SOLD', timestamp: soldItem.soldAt },
        { itemId: 'sim-1', eventType: 'REGISTERED', timestamp: soldItem.createdAt },
      ])
      .mockResolvedValueOnce([{ itemId: 'sim-1', eventType: 'REGISTERED', timestamp: soldItem.createdAt }])
    prismaMock.serializedItem.findMany.mockResolvedValue([soldItem])

    const first = await stockDashboardService.getRecentMovementsPage('venue-1', 1)
    const second = await stockDashboardService.getRecentMovementsPage('venue-1', 1, { page: 2 })

    expect(prismaMock.serializedItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }))
    expect([...first.movements, ...second.movements].map(movement => movement.type)).toEqual(['SOLD', 'REGISTERED'])
    expect(first.hasMore).toBe(true)
    expect(second.hasMore).toBe(false)
  })

  it('muestra una venta reciente aunque la SIM haya sido registrada hace años', async () => {
    const oldSoldItem = {
      id: 'sim-old-sold-today',
      serialNumber: '8952140000000000999',
      status: 'SOLD',
      categoryId: 'cat-1',
      category: { name: 'SIM 5G' },
      createdAt: new Date('2024-01-01T12:00:00.000Z'),
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
    } as any

    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([{ itemId: oldSoldItem.id, eventType: 'SOLD', timestamp: oldSoldItem.soldAt }])
    prismaMock.serializedItem.findMany.mockImplementation(async (args: any) => (args.where?.id?.in ? [oldSoldItem] : []))

    const result = await stockDashboardService.getRecentMovementsPage('venue-1', 20)

    expect(result.movements).toEqual([
      expect.objectContaining({ id: `sold-${oldSoldItem.id}`, type: 'SOLD', timestamp: oldSoldItem.soldAt }),
    ])
  })
})
