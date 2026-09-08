import { prismaMock } from '../../../__helpers__/setup'
import { cancelStockCount } from '@/services/mobile/inventory.mobile.service'

const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))

/**
 * «Dejarlo ir» no existía: un borrador que nadie iba a terminar se quedaba
 * «En progreso» para siempre. Cancelar es un RECLAMO ATÓMICO sobre
 * IN_PROGRESS — igual que el claim del confirm — para que dos cancelaciones
 * (o cancelar contra un confirm en vuelo) no se pisen.
 */
describe('cancelStockCount', () => {
  const COUNT = 'count-1'
  const VENUE = 'venue-1'
  const STAFF = 'staff-1'

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockReset()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  })

  it('cancela un borrador con un updateMany condicional y escribe la bitácora', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: COUNT, status: 'IN_PROGRESS', revision: 0, applyingAt: null }])
    prismaMock.stockCount.updateMany.mockResolvedValue({ count: 1 })
    const r = await cancelStockCount(COUNT, VENUE, STAFF)

    expect(prismaMock.stockCount.updateMany).toHaveBeenCalledWith({
      where: { id: COUNT, venueId: VENUE, status: 'IN_PROGRESS', revision: 0 },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date), revision: { increment: 1 } },
    })
    // El lock del padre va primero y se sostiene en la misma transacción que
    // el cambio de estado; PUT y confirm toman exactamente el mismo lock.
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.stockCount.updateMany.mock.invocationCallOrder[0])
    expect(prismaMock.stockCount.findFirst).not.toHaveBeenCalled()
    expect(r).toMatchObject({ id: COUNT, status: 'CANCELLED', revision: 1 })
    expect(typeof r.cancelledAt).toBe('string')
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STOCK_COUNT_CANCELLED', entity: 'StockCount', entityId: COUNT, venueId: VENUE, staffId: STAFF }),
    )
  })

  it('404 si el conteo no existe en este negocio (aislamiento de tenant)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    await expect(cancelStockCount(COUNT, VENUE, STAFF)).rejects.toThrow(/no encontrado/i)
    expect(prismaMock.stockCount.updateMany).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it.each([
    ['COMPLETED', /completado/i],
    ['APPLYING', /aplicando/i],
    ['CANCELLED', /ya estaba cancelado/i],
  ])('409 con el motivo cuando está %s', async (status, motivo) => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: COUNT, status, revision: status === 'CANCELLED' ? 1 : 0, applyingAt: new Date() }])
    await expect(cancelStockCount(COUNT, VENUE, STAFF)).rejects.toThrow(motivo)
    expect(mockLogAction).not.toHaveBeenCalled()
  })
})
