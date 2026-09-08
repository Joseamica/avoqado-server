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

  beforeEach(() => jest.clearAllMocks())

  it('cancela un borrador con un updateMany condicional y escribe la bitácora', async () => {
    prismaMock.stockCount.updateMany.mockResolvedValue({ count: 1 })
    const r = await cancelStockCount(COUNT, VENUE, STAFF)

    expect(prismaMock.stockCount.updateMany).toHaveBeenCalledWith({
      where: { id: COUNT, venueId: VENUE, status: 'IN_PROGRESS' },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
    })
    // 🔴 El ORDEN, no sólo la forma del `where`: se RECLAMA primero y sólo se diagnostica si
    // el reclamo falló. Leer el estado ANTES para decidir sería el TOCTOU clásico — dos
    // cancelaciones simultáneas lo verían IN_PROGRESS las dos.
    expect(prismaMock.stockCount.findFirst).not.toHaveBeenCalled()
    expect(r).toMatchObject({ id: COUNT, status: 'CANCELLED' })
    expect(typeof r.cancelledAt).toBe('string')
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STOCK_COUNT_CANCELLED', entity: 'StockCount', entityId: COUNT, venueId: VENUE, staffId: STAFF }),
    )
  })

  it('404 si el conteo no existe en este negocio (aislamiento de tenant)', async () => {
    prismaMock.stockCount.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.stockCount.findFirst.mockResolvedValue(null)
    await expect(cancelStockCount(COUNT, VENUE, STAFF)).rejects.toThrow(/no encontrado/i)
    expect(prismaMock.stockCount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: COUNT, venueId: VENUE } }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it.each([
    ['COMPLETED', /completado/i],
    ['APPLYING', /aplicando/i],
    ['CANCELLED', /ya estaba cancelado/i],
  ])('409 con el motivo cuando está %s', async (status, motivo) => {
    prismaMock.stockCount.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.stockCount.findFirst.mockResolvedValue({ id: COUNT, status } as never)
    await expect(cancelStockCount(COUNT, VENUE, STAFF)).rejects.toThrow(motivo)
    expect(mockLogAction).not.toHaveBeenCalled()
  })
})
